export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export function invalid(code: string, message: string): DomainError {
  return new DomainError(code, message);
}

export function forbidden(message = "You do not have access to this resource."): DomainError {
  return new DomainError("forbidden", message);
}

export function notFound(message = "Not found."): DomainError {
  return new DomainError("not_found", message);
}

export function unauthenticated(message = "Sign in is required."): DomainError {
  return new DomainError("unauthenticated", message);
}
