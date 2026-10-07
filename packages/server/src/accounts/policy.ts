import type { AccountUser } from "@mockdata/accounts";
import { assertWithinDiskQuota } from "@mockdata/accounts";
import { assertRowBudget } from "@mockdata/cli";
import { HttpError } from "../http.js";
import type { Policy } from "../hosted.js";
import { assertSchemaShape, beginRun, lockedLlmConfig, throttleRun, throttleValidate } from "./guards.js";
import type { AccountsRuntime } from "./runtime.js";

/** Largest schema file a signed-in user may save. */
const MAX_ACCOUNT_FILE_BYTES = 1024 * 1024;

/** What one signed-in user may do on this server: the account limits, applied to that user for one request. */
export function accountPolicy(accounts: AccountsRuntime, user: AccountUser): Policy {
  return {
    hideInternals: true,
    lockedModels: true,
    allowDatabase: false,
    lockLlm: lockedLlmConfig,
    throttleRun: () => throttleRun(accounts, user),
    throttleValidate: () => throttleValidate(accounts, user),
    checkSchema: (schema) => assertSchemaShape(accounts, schema),
    checkRun(schema) {
      assertSchemaShape(accounts, schema);
      assertRowBudget(schema, accounts.limits.maxRows);
    },
    beginRun: (schema) => beginRun(accounts, user, schema),
    checkWrite(root, { netBytes, newFiles, fileBytes }) {
      if (fileBytes !== undefined && fileBytes > MAX_ACCOUNT_FILE_BYTES) throw new HttpError(413, "Schema files are limited to 1 MB");
      assertWithinDiskQuota(root, netBytes, accounts.limits.userQuotaBytes, { newFiles, maxFiles: accounts.limits.maxFiles });
    },
  };
}
