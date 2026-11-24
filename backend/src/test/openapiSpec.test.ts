import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../app";
import { openApiSpec } from "../openapi";

const spec = openApiSpec as any;

function collectRefs(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, found);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") found.push(value);
      else collectRefs(value, found);
    }
  }
  return found;
}

function resolvePointer(root: unknown, ref: string): unknown {
  expect(ref.startsWith("#/")).toBe(true);
  const parts = ref.slice(2).split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  return parts.reduce<any>((node, part) => node?.[part], root);
}

describe("OpenAPI specification", () => {
  it("is served without authentication", async () => {
    const res = await request(app).get("/api/v1/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(spec);
  });

  it("documents the auth, SNMP, organisation and tenancy operations", () => {
    const expected: [string, string][] = [
      ["/auth/login", "post"],
      ["/auth/logout", "post"],
      ["/auth/me", "get"],
      ["/auth/change-password", "post"],
      ["/auth/users", "get"],
      ["/auth/users", "post"],
      ["/auth/users/{id}", "put"],
      ["/auth/users/{id}", "delete"],
      ["/snmp/status", "get"],
      ["/snmp/sources", "get"],
      ["/snmp/sources", "post"],
      ["/snmp/sources/{id}", "put"],
      ["/snmp/sources/{id}", "delete"],
      ["/snmp/rules", "get"],
      ["/snmp/rules", "post"],
      ["/snmp/rules/{id}", "put"],
      ["/snmp/rules/{id}", "delete"],
      ["/snmp/log", "get"],
      ["/orgs", "get"],
      ["/orgs", "post"],
      ["/orgs/{id}", "put"],
      ["/orgs/{id}", "delete"],
      ["/orgs/{id}/users", "get"],
      ["/orgs/{id}/users", "post"],
      ["/orgs/users/{userId}", "put"],
      ["/system/tenancy", "get"],
      ["/system/tenancy/enable", "post"],
      ["/events/ingest", "post"],
    ];

    for (const [path, method] of expected) {
      const operation = spec.paths[path]?.[method];
      expect(operation, `${method.toUpperCase()} ${path}`).toBeDefined();
      expect(Object.keys(operation.responses ?? {}).length, `${method.toUpperCase()} ${path} responses`).toBeGreaterThan(0);
    }
  });

  it("has only resolvable local refs", () => {
    const refs = collectRefs(spec);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(resolvePointer(spec, ref), ref).toBeDefined();
    }
  });

  it("declares both security schemes used by the API", () => {
    expect(spec.components.securitySchemes.cookieAuth).toMatchObject({
      type: "apiKey", in: "cookie", name: "ag_session",
    });
    expect(spec.components.securitySchemes.ingestApiKey).toMatchObject({
      type: "apiKey", in: "header", name: "X-API-Key",
    });
    expect(spec.paths["/events/ingest"].post.security).toEqual([{ ingestApiKey: [] }]);
  });
});
