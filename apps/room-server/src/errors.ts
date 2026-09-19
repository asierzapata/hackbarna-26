export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string) => new ApiError(400, "bad_request", msg);
export const unauthorized = (msg = "authentication required") => new ApiError(401, "unauthorized", msg);
export const forbidden = (msg = "forbidden") => new ApiError(403, "forbidden", msg);
export const notFound = (msg = "not found") => new ApiError(404, "not_found", msg);
export const conflict = (msg: string) => new ApiError(409, "conflict", msg);
export const tooLarge = (msg = "payload too large") => new ApiError(413, "payload_too_large", msg);
export const tooMany = (msg = "rate limited") => new ApiError(429, "rate_limited", msg);
export const unavailable = (msg = "service unavailable") => new ApiError(503, "unavailable", msg);
export const badGateway = (msg = "upstream failure") => new ApiError(502, "bad_gateway", msg);
