const path = require('path');
// Ensure we can find the project root (parent of api/)
process.chdir(path.join(__dirname, '..'));

const serverless = require('serverless-http');
const app = require('../server');

module.exports = serverless(app);
