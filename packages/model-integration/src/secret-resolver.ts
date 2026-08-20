export interface SecretResolver {
  resolveSecret(secretRef: string): Promise<string | null>;
}
