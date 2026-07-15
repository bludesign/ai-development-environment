/* eslint-disable @typescript-eslint/no-require-imports */
const {
  mockTranslations,
  useTranslations: createTranslator,
} = require("./next-intl");

const getRequestConfig = (configFunction) => configFunction;
const getMessages = () => Promise.resolve(mockTranslations);
const getTranslations = (namespaceOrOptions) => {
  const namespace =
    typeof namespaceOrOptions === "string"
      ? namespaceOrOptions
      : namespaceOrOptions?.namespace;

  return Promise.resolve(createTranslator(namespace));
};

module.exports = {
  getRequestConfig,
  getMessages,
  getTranslations,
};
