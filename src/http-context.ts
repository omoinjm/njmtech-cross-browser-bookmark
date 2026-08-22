import type { Env, AuthenticatedUser } from './env';
import type { Dependencies } from './container';

export type Variables = {
  deps: Dependencies;
  // Set by require-session.ts. Not present on public routes (health) or on
  // routes still gated by the legacy require-api-token.ts during rollout.
  user: AuthenticatedUser;
};

export type AppEnv = {
  Bindings: Env;
  Variables: Variables;
};
