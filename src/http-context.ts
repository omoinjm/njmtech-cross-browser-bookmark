import type { Env } from './env';
import type { Dependencies } from './container';

export type Variables = {
  deps: Dependencies;
};

export type AppEnv = {
  Bindings: Env;
  Variables: Variables;
};
