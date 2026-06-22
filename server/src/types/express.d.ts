// Type augmentation for Express Request — adds `actor` property set by actorMiddleware.
// Declared as `any` to remain compatible with all downstream consumers (BoardActor,
// AuthorizationActor, etc.) which narrow the shape themselves through parameter types.

declare namespace Express {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Request {
    actor: any;
  }
}
