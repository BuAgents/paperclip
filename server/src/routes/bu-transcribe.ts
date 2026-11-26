// bu-fork: speech-to-text for the composer mic button (local Whisper, no audio leaves the machine).
import { Router } from "express";
import multer from "multer";
import { badRequest } from "../errors.js";
import { MAX_TRANSCRIBE_BYTES, transcribeAudio } from "../services/bu-transcriber.js";
import { assertBoardOrgAccess } from "./authz.js";

const EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};

export function buTranscribeRoutes() {
  const router = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_TRANSCRIBE_BYTES, files: 1 } });

  // Authorize before multer buffers the upload: signed-in board users with a
  // company membership (or instance admins / local implicit board). Agents are refused.
  router.post("/bu/transcribe", (req, _res, next) => { assertBoardOrgAccess(req); next(); }, upload.single("audio"), async (req, res) => {
    const file = req.file;
    if (!file || file.size === 0) throw badRequest("Attach the recording as the \"audio\" field");
    const mime = (file.mimetype || "").split(";")[0]!.trim().toLowerCase();
    const extension = EXTENSIONS[mime];
    if (!extension) throw badRequest(`Unsupported audio type ${mime || "(none)"}`);
    const transcript = await transcribeAudio(file.buffer, extension);
    res.json(transcript);
  });

  return router;
}
