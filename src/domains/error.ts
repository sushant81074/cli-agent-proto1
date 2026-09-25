export class EcoError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);

    this.name = 'EcoError';
    this.code = code;
  }
}

export class ConfigError extends EcoError {
  constructor(message: string) {
    super('CONFIG_ERROR', message);
  }
}

export class CliError extends EcoError {
  constructor(message: string) {
    super('CLI_ERROR', message);
  }
}