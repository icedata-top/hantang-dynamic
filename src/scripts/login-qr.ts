// The QR command must work before config.toml has any authentication entry.
process.env.SESSDATA ??= "qr-login-placeholder";
process.env.BILIBILI_UID ??= "0";

void import("./loginQr.js")
  .then(({ runLoginQr }) => runLoginQr(process.argv.slice(2)))
  .catch((error) => {
    console.error(
      `login-qr failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
