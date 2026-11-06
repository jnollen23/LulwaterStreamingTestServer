import { App } from 'aws-cdk-lib';
import { StreamingStack } from './streaming-stack.js';

const app = new App();
new StreamingStack(app, 'StreamingWebsite', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
