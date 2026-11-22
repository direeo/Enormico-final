require('express');

const { createApplication } = require('./user-api-sqlite');

module.exports = createApplication().app;
