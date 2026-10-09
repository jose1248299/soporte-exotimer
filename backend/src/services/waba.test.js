const test = require("node:test");
const assert = require("node:assert/strict");
const posts = [];
let response = { messages: [{ id: "wamid.synthetic" }] };
require.cache[require.resolve("../config")] = { exports: { meta: { graphVersion: "v25.0", phoneNumberId: "test-phone", accessToken: "synthetic-token" } } };
require.cache[require.resolve("axios")] = { exports: { post: async (url, payload, options) => {
  posts.push({ url, payload, options }); return { data: response };
} } };
const waba = require("./waba");

test("Graph sends phone numbers in to and BSUIDs in recipient for all media types", async () => {
  await waba.sendTextMessage("+51 986 809 322", "Synthetic test");
  assert.equal(posts.at(-1).payload.to, "51986809322");
  assert.equal(posts.at(-1).payload.recipient, undefined);
  for (const send of [() => waba.sendTextMessage("PE.123456", "test"),
    () => waba.sendImageMessage("PE.123456", "https://example.com/test.png"),
    () => waba.sendDocumentMessage("PE.123456", "https://example.com/test.pdf")]) {
    await send();
    assert.equal(posts.at(-1).payload.recipient, "PE.123456");
    assert.equal(posts.at(-1).payload.to, undefined);
    assert.equal(posts.at(-1).options.timeout, 30000);
  }
});

test("missing provider ID is uncertain, not success", async () => {
  response = { success: true };
  await assert.rejects(() => waba.sendTextMessage("51986809322", "test"), error => error.deliveryUnknown === true);
});
