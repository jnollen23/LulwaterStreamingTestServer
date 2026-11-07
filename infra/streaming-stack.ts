import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Size, Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat, type NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import {
  DEGRADED_AT_GB_PER_DAY,
  OFF_AT_GB_PER_DAY,
  SIGNING_KEY_PARAM,
  ALERT_EMAILS,
  STREAM_SIGNING_MODE,
  STREAMING_MODE_OVERRIDE_PARAM,
  STREAMING_MODE_PARAM,
} from './constants.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Layout of the media bucket:
 *   raw/     you drop FLAC files here (S3 console)  -> triggers ingest
 *   stream/  HLS output from ffmpeg (ingest Lambda) -> served at /stream/*, signature required (see STREAM_SIGNING_MODE)
 *   art/     cover art pulled from FLAC tags         -> served at /art/*, public
 *
 * Everything is served from one CloudFront domain:
 *   /         website (site bucket)
 *   /api/*    API Gateway -> API Lambda
 *   /stream/* media bucket (signed)
 *   /art/*    media bucket
 */
export class StreamingStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ---------- Storage ----------
    const mediaBucket = new s3.Bucket(this, 'MediaBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN, // never delete the library on `cdk destroy`
    });

    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const tracksTable = new dynamodb.TableV2(this, 'TracksTable', {
      partitionKey: { name: 'trackId', type: dynamodb.AttributeType.STRING },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Royalty play log: one row per listen in progress (expires via TTL) plus per-song daily totals.
    // See backend/shared/plays.ts. RETAIN: this is the record royalties are paid from.
    const playsTable = new dynamodb.TableV2(this, 'PlaysTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'expiresAt',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ---------- Stream signing key ----------
    const publicKeyFile = path.join(root, 'keys', 'public_key.pem');
    if (!existsSync(publicKeyFile)) {
      throw new Error('keys/public_key.pem not found — run `npm run setup-keys` first.');
    }
    const publicKey = new cloudfront.PublicKey(this, 'StreamSigningKey', {
      encodedKey: readFileSync(publicKeyFile, 'utf8'),
    });
    const keyGroup = new cloudfront.KeyGroup(this, 'StreamKeyGroup', { items: [publicKey] });

    // Parameters are written at run time (spend guard / npm run streaming-mode), not by CloudFormation,
    // so a deploy never resets the spend switch.
    const ssmParamArn = (name: string) =>
      this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: name.slice(1) });

    // ---------- Lambda defaults ----------
    const fnDefaults: NodejsFunctionProps = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      bundling: {
        format: OutputFormat.ESM,
        bundleAwsSDK: true,
        minify: true,
        sourceMap: true,
        // lets bundled CommonJS deps call require() inside an ESM bundle
        banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
    };
    const baseEnv = { TRACKS_TABLE: tracksTable.tableName, NODE_OPTIONS: '--enable-source-maps' };

    // ---------- API ----------
    const apiFn = new NodejsFunction(this, 'ApiFn', {
      ...fnDefaults,
      entry: path.join(root, 'backend/api/handler.ts'),
      memorySize: 512,
      timeout: Duration.seconds(10),
      environment: {
        ...baseEnv,
        SIGNING_KEY_PARAM,
        SIGNING_KEY_PAIR_ID: publicKey.publicKeyId,
        STREAM_SIGNING_MODE,
        MEDIA_BUCKET: mediaBucket.bucketName,
        PLAYS_TABLE: playsTable.tableName,
        STREAMING_MODE_PARAM,
      },
    });
    tracksTable.grantReadData(apiFn);
    playsTable.grantReadWriteData(apiFn);
    apiFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:UpdateItem'], // like counter only
      resources: [tracksTable.tableArn],
    }));
    mediaBucket.grantRead(apiFn, 'stream/*.m3u8'); // signed-URL mode rewrites playlists on the fly
    apiFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [ssmParamArn(SIGNING_KEY_PARAM), ssmParamArn(STREAMING_MODE_PARAM)],
    }));

    const httpApi = new apigw.HttpApi(this, 'HttpApi');
    httpApi.addRoutes({
      path: '/api/{proxy+}',
      methods: [apigw.HttpMethod.ANY],
      integration: new HttpLambdaIntegration('ApiIntegration', apiFn),
    });

    // ---------- Ingest: raw/ upload -> tags + ffmpeg HLS transcode -> catalog READY/ERROR ----------
    const ffmpegDir = path.join(root, 'layers', 'ffmpeg');
    if (!existsSync(path.join(ffmpegDir, 'bin', 'ffmpeg'))) {
      throw new Error('layers/ffmpeg/bin/ffmpeg not found — run `npm run fetch-ffmpeg` first.');
    }
    const ffmpegLayer = new lambda.LayerVersion(this, 'FfmpegLayer', {
      code: lambda.Code.fromAsset(ffmpegDir),
      compatibleArchitectures: [lambda.Architecture.ARM_64],
      description: 'Static ffmpeg build at /opt/bin/ffmpeg',
    });

    const ingestFn = new NodejsFunction(this, 'IngestFn', {
      ...fnDefaults,
      entry: path.join(root, 'backend/ingest/handler.ts'),
      layers: [ffmpegLayer],
      memorySize: 3008, // Lambda CPU scales with memory; ffmpeg uses it all
      ephemeralStorageSize: Size.gibibytes(4), // /tmp holds the FLAC + HLS output (a long hi-res FLAC can top 1 GB)
      timeout: Duration.minutes(15),
      retryAttempts: 0, // failures are recorded as ERROR in the catalog; a retry would add a duplicate track
      environment: { ...baseEnv, MEDIA_BUCKET: mediaBucket.bucketName }, // bucket: thumbnail backfill (no S3 event)
    });
    mediaBucket.grantRead(ingestFn, 'raw/*');
    mediaBucket.grantRead(ingestFn, 'art/*'); // thumbnail backfill reads existing art
    mediaBucket.grantPut(ingestFn, 'art/*');
    mediaBucket.grantPut(ingestFn, 'stream/*');
    // A re-upload replaces the older copy of the song: list + delete its stream folder and art.
    mediaBucket.grantRead(ingestFn, 'stream/*');
    mediaBucket.grantDelete(ingestFn, 'stream/*');
    mediaBucket.grantDelete(ingestFn, 'art/*');
    tracksTable.grantReadWriteData(ingestFn); // scan for older copies, carry their likes over, delete them
    mediaBucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(ingestFn), { prefix: 'raw/' });

    // ---------- CloudFront ----------
    const siteOrigin = origins.S3BucketOrigin.withOriginAccessControl(siteBucket);
    const mediaOrigin = origins.S3BucketOrigin.withOriginAccessControl(mediaBucket);
    const apiOrigin = new origins.HttpOrigin(`${httpApi.apiId}.execute-api.${this.region}.${this.urlSuffix}`);

    const distribution = new cloudfront.Distribution(this, 'Cdn', {
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // US/Canada/Europe edges; widen if listeners are elsewhere
      defaultBehavior: {
        origin: siteOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
        '/stream/*': {
          origin: mediaOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          trustedKeyGroups: [keyGroup],
        },
        '/art/*': {
          origin: mediaOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        },
      },
    });

    // ---------- Spend guard: today's CloudFront traffic -> spend switch for free listeners ----------
    // See backend/spend-guard/handler.ts. (A plain CloudWatch alarm can't do this here: CloudFront metrics live
    // only in us-east-1, alarms can't count "since midnight Eastern", and they can't write the switch.)
    const spendAlerts = new sns.Topic(this, 'SpendAlerts', { displayName: 'Lullwater spend switch' });
    for (const email of ALERT_EMAILS) spendAlerts.addSubscription(new subs.EmailSubscription(email));

    const spendGuardFn = new NodejsFunction(this, 'SpendGuardFn', {
      ...fnDefaults,
      entry: path.join(root, 'backend/spend-guard/handler.ts'),
      memorySize: 256,
      timeout: Duration.seconds(30),
      retryAttempts: 0, // the next run is 5 minutes away anyway
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        DISTRIBUTION_ID: distribution.distributionId,
        STREAMING_MODE_PARAM,
        STREAMING_MODE_OVERRIDE_PARAM,
        DEGRADED_AT_GB_PER_DAY: String(DEGRADED_AT_GB_PER_DAY),
        OFF_AT_GB_PER_DAY: String(OFF_AT_GB_PER_DAY),
        SPEND_ALERT_TOPIC: spendAlerts.topicArn,
      },
    });
    spendAlerts.grantPublish(spendGuardFn);
    spendGuardFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:GetMetricData'], // has no resource-level permissions
      resources: ['*'],
    }));
    spendGuardFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [ssmParamArn(STREAMING_MODE_PARAM), ssmParamArn(STREAMING_MODE_OVERRIDE_PARAM)],
    }));
    spendGuardFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:PutParameter'],
      resources: [ssmParamArn(STREAMING_MODE_PARAM)],
    }));
    new events.Rule(this, 'SpendGuardSchedule', {
      schedule: events.Schedule.rate(Duration.minutes(5)),
      targets: [new targets.LambdaFunction(spendGuardFn, { retryAttempts: 0 })],
    });

    // Watch the watcher: mode emails only go out on a CHANGE, so a broken spend guard would otherwise be silent
    // (and free streaming would have no cost cap). Both alarms email the same list, and email again once fixed.
    const alertAction = new cwActions.SnsAction(spendAlerts);
    const guardAlarms = [
      new cloudwatch.Alarm(this, 'SpendGuardFailingAlarm', {
        alarmName: 'Lullwater spend guard is failing',
        alarmDescription:
          'The spend guard errored in 3 of its last 4 runs, so the spend switch is stuck in its current mode. ' +
          'Check the SpendGuardFn logs in CloudWatch (us-east-2). To be safe meanwhile: npm run streaming-mode -- degraded',
        metric: spendGuardFn.metricErrors({ period: Duration.minutes(5), statistic: cloudwatch.Stats.SUM }),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 4,
        datapointsToAlarm: 3,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING, // no runs is the other alarm's job
      }),
      new cloudwatch.Alarm(this, 'SpendGuardStoppedAlarm', {
        alarmName: 'Lullwater spend guard stopped running',
        alarmDescription:
          'The spend guard has not run for 15 minutes (it should run every 5), so the spend switch is stuck. ' +
          'Check the SpendGuardSchedule rule in EventBridge (us-east-2). To be safe meanwhile: npm run streaming-mode -- degraded',
        metric: spendGuardFn.metricInvocations({ period: Duration.minutes(15), statistic: cloudwatch.Stats.SUM }),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING, // no data at all = it isn't running
      }),
    ];
    for (const alarm of guardAlarms) {
      alarm.addAlarmAction(alertAction);
      alarm.addOkAction(alertAction);
    }

    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.asset(path.join(root, 'frontend/dist'))],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'],
    });

    // ---------- Outputs ----------
    new CfnOutput(this, 'SiteUrl', { value: `https://${distribution.distributionDomainName}` });
    new CfnOutput(this, 'MediaBucketName', {
      value: mediaBucket.bucketName,
      description: 'Upload FLAC files into the raw/ folder of this bucket',
    });
    new CfnOutput(this, 'TracksTableName', { value: tracksTable.tableName });
    new CfnOutput(this, 'PlaysTableName', {
      value: playsTable.tableName,
      description: 'Royalty play log; npm run royalty-report -- <yyyy-mm> reads it',
    });
  }
}
