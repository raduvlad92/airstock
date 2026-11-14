import 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    databases: { ownerUrl: string; appUrl: string };
  }
}
