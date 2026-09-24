// Names shared by the code that builds the sample database (main) and the
// code that wires it up as connections (renderer). See src/main/sample.ts.

export type SampleEnv = 'local' | 'staging' | 'prod';
export const SAMPLE_ENVS: SampleEnv[] = ['local', 'staging', 'prod'];

export const SAMPLE_SET_NAME = 'shop (sample)';

export function sampleFileName(env: SampleEnv): string {
  return `overdb-sample-shop-${env}.sqlite`;
}

/// Which environment of the sample a file is, or null for any other file.
/// By name only — the folder moves with a dev profile.
export function sampleEnvOf(file: string | undefined): SampleEnv | null {
  if (!file) return null;
  const base = file.split(/[\\/]/).pop() ?? '';
  return SAMPLE_ENVS.find((env) => base === sampleFileName(env)) ?? null;
}
