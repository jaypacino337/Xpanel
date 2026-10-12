export class ValidationError extends Error {}

export class AccountUnavailableError extends Error {}

export class RateLimitedError extends Error {
  constructor(endpoint, resetAt) {
    super(`Rate limited on ${endpoint} until ${new Date(resetAt).toISOString()}`);
    this.resetAt = resetAt;
  }
}
