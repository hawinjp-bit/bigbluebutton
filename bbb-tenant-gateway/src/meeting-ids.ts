const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;

export function validateExternalId(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !EXTERNAL_ID_PATTERN.test(value)) {
    throw new Error(`${fieldName} must be 1-128 characters using letters, numbers, dot, underscore, tilde, or hyphen`);
  }
  return value;
}

export function namespacedId(prefix: string, externalId: string, maxLength = 256): string {
  const result = `${prefix}${externalId}`;
  if (result.length > maxLength) throw new Error('Namespaced identifier is too long');
  return result;
}

