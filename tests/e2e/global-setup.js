const path = require("node:path");
const { buildExtension } = require("../../scripts/build-extension");

// Build once before workers start; parallel workers must not replace dist
// while another worker is loading the extension's background/page scripts.
module.exports = () => { buildExtension(path.resolve(__dirname, "../..")); };
