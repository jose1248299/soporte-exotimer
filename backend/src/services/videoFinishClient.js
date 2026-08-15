const axios = require("axios");
const config = require("../config");

async function requestRecoveryRecording({ competitionId, time }) {
  const response = await axios.get(
    `${config.finisherData.publicUrl}/api/video-finish/recovery-recording`,
    {
      params: { competitionId, time },
      timeout: 20000,
      validateStatus: () => true,
      headers: { Accept: "application/json" },
    }
  );

  return {
    status: response.status,
    data: response.data || {},
  };
}

module.exports = { requestRecoveryRecording };
