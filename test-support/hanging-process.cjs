const fs = require("node:fs");

fs.writeFileSync(process.argv[2], String(process.pid), "utf8");
setInterval(() => {}, 1000);
