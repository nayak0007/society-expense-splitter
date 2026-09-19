/**
 * SES React Native Jest preset stub. Will gain RN-specific transform and
 * moduleNameMapper config when mobile tests land.
 */
module.exports = {
  ...require("./base"),
  testEnvironment: "node",
};
