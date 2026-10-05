/** 统一 HTTP 错误：携带 HTTP 状态码与结构化详情 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }

  static badRequest(code: string, message: string, details?: unknown): HttpError {
    return new HttpError(400, code, message, details);
  }

  static notFound(code: string, message: string, details?: unknown): HttpError {
    return new HttpError(404, code, message, details);
  }

  /** 409 Conflict：修订号过期（乐观并发） */
  static staleRevision(actual: number, expected: number): HttpError {
    return new HttpError(
      409,
      'stale_revision',
      `修订号已过期：携带的 ${expected} 与当前修订号 ${actual} 不一致，请重新读取最新布局后再提交`,
      { expectedRevision: expected, currentRevision: actual },
    );
  }

  /** 409 Conflict：核对作业相关冲突（重复开工 / 上报号冲突 / 结案拒绝 / 作业已结案） */
  static conflict(code: string, message: string, details?: unknown): HttpError {
    return new HttpError(409, code, message, details);
  }

  /** 422 Unprocessable Entity：请求格式合法但违反配载规则，整批拒绝 */
  static validationFailed(violations: unknown[]): HttpError {
    return new HttpError(
      422,
      'validation_failed',
      `配载校验未通过，共 ${violations.length} 项违反，整批调整已拒绝`,
      { violationCount: violations.length, violations },
    );
  }

  static invalidRequest(code: string, message: string, details?: unknown): HttpError {
    return new HttpError(400, code, message, details);
  }
}
