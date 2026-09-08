import type { Env, AuthenticatedUser } from './env';
import type { Dependencies } from './container';

export type Variables = {
  deps: Dependencies;
  // Set by require-session.ts. Not present on public routes (health) or on
  // routes still gated by the legacy require-api-token.ts during rollout.
  user: AuthenticatedUser;
  // Set by require-profile.ts, applied after requireSession on every route
  // whose data is profile-scoped (bookmarks/categories/tags/search) — not
  // present on auth.ts, admin.ts, or profiles.ts itself, which manage the
  // set of profiles rather than operating within one.
  profile: { id: number; name: string };
};

export type AppEnv = {
  Bindings: Env;
  Variables: Variables;
};
