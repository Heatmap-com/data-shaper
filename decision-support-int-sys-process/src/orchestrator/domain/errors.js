export class OrchestratorError extends Error {
  constructor(message, { exitCode = 1, cause } = {}) {
    super(message, { cause });
    this.name = this.constructor.name;
    this.exitCode = exitCode;
  }
}
export class DescriptorError extends OrchestratorError {}
export class TemplateError extends OrchestratorError {}
export class NotFoundError extends OrchestratorError {}
