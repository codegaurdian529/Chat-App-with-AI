const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const User = require("../models/User");
const Message = require("../models/Message");
const Group = require("../models/Group");

const router = express.Router();

// ----- File upload settings -----
const uploadDir = path.join(__dirname, "..", "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

// Only these file types are accepted
const TYPES = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
};

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    // random file name, so nobody can guess the link
    filename: (req, file, cb) =>
      cb(null, crypto.randomBytes(16).toString("hex") + TYPES[file.mimetype]),
  }),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
  fileFilter: (req, file, cb) =>
    TYPES[file.mimetype]
      ? cb(null, true)
      : cb(new Error("Only JPG, PNG, GIF, WEBP photos and MP4, WEBM, MOV videos are allowed")),
});

// Checks the login token on every request to this file's routes
router.use((req, res, next) => {
  try {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ error: "Not logged in" });
  }
});

// Upload one photo or video
router.post("/upload", (req, res) => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      const msg = err.code === "LIMIT_FILE_SIZE" ? "File too big (max 25 MB)" : err.message;
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: "No file received" });
    res.json({ url: "/uploads/" + req.file.filename });
  });
});

// List of all other users, with when they were last seen
router.get("/users", async (req, res) => {
  const users = await User.find({ username: { $ne: req.user.username } }).select(
    "username lastSeen"
  );
  res.json(users.map((u) => ({ username: u.username, lastSeen: u.lastSeen })));
});

// For the chat list: the last message and unread count of each conversation
router.get("/overview", async (req, res) => {
  const me = req.user.username;

  // One-to-one chats: last message and number of unread messages per person
  const direct = await Message.aggregate([
    { $match: { group: null, $or: [{ from: me }, { to: me }] } },
    { $sort: { createdAt: -1 } },
    { $addFields: { other: { $cond: [{ $eq: ["$from", me] }, "$to", "$from"] } } },
    {
      $group: {
        _id: "$other",
        last: { $first: "$$ROOT" },
        unread: {
          $sum: {
            $cond: [{ $and: [{ $eq: ["$to", me] }, { $ne: ["$read", true] }] }, 1, 0],
          },
        },
      },
    },
  ]);

  // Group chats: last message of each group I am in
  const myGroups = await Group.find({ members: me }).select("_id");
  const groupIds = myGroups.map((g) => String(g._id));
  const lastInGroups = groupIds.length
    ? await Message.aggregate([
        { $match: { group: { $in: groupIds } } },
        { $sort: { createdAt: -1 } },
        { $group: { _id: "$group", last: { $first: "$$ROOT" } } },
      ])
    : [];

  const pack = (id, last, unread) => ({
    id,
    text: last.text,
    file: last.file,
    from: last.from,
    at: last.createdAt,
    unread,
  });

  res.json({
    direct: direct.map((d) => pack(d._id, d.last, d.unread)),
    groups: lastInGroups.map((d) => pack(d._id, d.last, 0)),
  });
});

// Saved messages between me and one other user
router.get("/messages/:username", async (req, res) => {
  const me = req.user.username;
  const other = req.params.username;
  const messages = await Message.find({
    $or: [
      { from: me, to: other },
      { from: other, to: me },
    ],
  }).sort({ createdAt: 1 });
  res.json(messages);
});

// Groups I am a member of
router.get("/groups", async (req, res) => {
  const groups = await Group.find({ members: req.user.username }).sort({ createdAt: 1 });
  res.json(groups);
});

// Saved messages of one group (only members can read them)
router.get("/groups/:id/messages", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ error: "Bad group id" });
  }
  const group = await Group.findOne({ _id: req.params.id, members: req.user.username });
  if (!group) return res.status(403).json({ error: "You are not in this group" });

  const messages = await Message.find({ group: String(group._id) }).sort({ createdAt: 1 });
  res.json(messages);
});

module.exports = router;