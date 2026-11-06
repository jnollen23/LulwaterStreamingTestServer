import { createContext, useContext, type ReactNode } from 'react';

export interface User {
  id: string;
  email?: string;
}

interface AuthState {
  user: User | null;
  /** Bearer token for API calls; null while anonymous. */
  getToken: () => Promise<string | null>;
  login: () => void;
  logout: () => void;
}

/**
 * LOGIN HOOK — everyone is anonymous for now.
 * When login is added, replace this provider's internals with the real one (e.g. Amplify Auth / Cognito
 * hosted UI) and keep the same AuthState shape so the rest of the app doesn't change.
 */
const anonymous: AuthState = {
  user: null,
  getToken: async () => null,
  login: () => console.warn('Login is not enabled yet'),
  logout: () => {},
};

const AuthContext = createContext<AuthState>(anonymous);

export function AuthProvider({ children }: { children: ReactNode }) {
  return <AuthContext.Provider value={anonymous}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
