import { test } from "node:test";
import assert from "node:assert/strict";
import {
  credentialValues,
  storageDiagnostic,
} from "../server/storage-errors.ts";

test("storage diagnostics retain actionable reasons but redact OAuth, URL and config secrets", () => {
  const secrets = credentialValues(
    'token = {"access_token":"RAW_ACCESS_FIXTURE","refresh_token":"RAW_REFRESH_FIXTURE"}\nclient_secret = RAW_CLIENT_FIXTURE\npassword = RAW_PASSWORD_FIXTURE',
  );
  const detail = storageDiagnostic(
    {
      error:
        "HTTP 401: invalid_grant; RAW_ACCESS_FIXTURE RAW_REFRESH_FIXTURE RAW_CLIENT_FIXTURE RAW_PASSWORD_FIXTURE\nhttps://user:URL_PASSWORD@api.example.com/files?code=CODE_FIXTURE&access_token=URL_TOKEN_FIXTURE\nAuthorization: Bearer AUTH_FIXTURE\nSESSDATA=COOKIE_FIXTURE",
      input: { secret: "INPUT_SECRET_FIXTURE" },
    },
    secrets,
  );
  assert(detail.includes("HTTP 401: invalid_grant"));
  assert(detail.includes("https://api.example.com/files"));
  for (const secret of [
    "RAW_ACCESS_FIXTURE",
    "RAW_REFRESH_FIXTURE",
    "RAW_CLIENT_FIXTURE",
    "RAW_PASSWORD_FIXTURE",
    "URL_PASSWORD",
    "CODE_FIXTURE",
    "URL_TOKEN_FIXTURE",
    "AUTH_FIXTURE",
    "COOKIE_FIXTURE",
    "INPUT_SECRET_FIXTURE",
  ])
    assert(!detail.includes(secret), secret);
  assert(
    storageDiagnostic(
      new Error("connect ECONNREFUSED", { cause: new Error("socket closed") }),
    ).includes("ECONNREFUSED"),
  );
  assert.equal(storageDiagnostic("x".repeat(10000)).length, 4000);
});
