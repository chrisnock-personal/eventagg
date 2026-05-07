import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";

export interface ApiError extends Error {
  statusCode?: number;
}

export function errorHandler(
  err: ApiError,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: "Validation error",
      details: err.errors.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      })),
    });
    return;
  }

  const status = err.statusCode ?? 500;
  const message = err.message ?? "Internal server error";

  if (status >= 500) {
    console.error("Server error:", err);
  }

  res.status(status).json({ error: message });
}

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: "Route not found" });
}

export function createError(message: string, statusCode: number): ApiError {
  const err: ApiError = new Error(message);
  err.statusCode = statusCode;
  return err;
}
