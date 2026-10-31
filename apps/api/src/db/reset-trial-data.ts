import { pool } from "./pool.js";
import { resetTrialData } from "./reset-trial-data.service.js";

const confirmation = process.env.TEZKAR_RESET_TRIAL_DATA_CONFIRM;
if (confirmation !== "DELETE_TRIAL_DATA") {
  throw new Error(
    "Refusing to reset data. Set TEZKAR_RESET_TRIAL_DATA_CONFIRM=DELETE_TRIAL_DATA for a deliberate one-time reset."
  );
}

try {
  const report = await resetTrialData(null);
  console.log("Tezkar trial-data reset completed.");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await pool.end();
}
