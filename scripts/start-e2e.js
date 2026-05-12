const { spawn } = require("child_process");
const rawPort = parseInt(process.env.SOKRA_TEST_PORT, 10);
const port = (rawPort >= 1 && rawPort <= 65535) ? rawPort : 3000;
const child = spawn("php", ["-S", `127.0.0.1:${port}`, "router.php"], { stdio: "inherit" });
child.on("exit", code => process.exit(code ?? 0));
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
