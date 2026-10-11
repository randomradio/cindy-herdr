'use strict';

class PromptGuardError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function assertRemotePromptBody(body) {
  if (body.ok !== true) {
    throw new PromptGuardError(body.code || 'SESSION_MISMATCH', body.message || 'Live transcript identity does not match the conversation shown.');
  }
  return body;
}

module.exports = { assertRemotePromptBody, PromptGuardError };
