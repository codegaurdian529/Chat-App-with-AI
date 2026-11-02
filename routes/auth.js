const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");

const router = express.Router();

function makeToken(user) {
  return jwt.sign(
    { id: user._id, username: user.username },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

router.post("/signup", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password || password.length < 6) {
      return res
        .status(400)
        .json({ error: "Enter a username and a password of 6+ characters" });
    }

    // The name "AI Assistant" belongs to the chatbot
    const simple = String(username).trim().replace(/\s+/g, " ").toLowerCase();
    if (simple === "ai assistant") {
      return res.status(400).json({ error: "That username is reserved" });
    }

    const exists = await User.findOne({ username });
    if (exists) return res.status(400).json({ error: "Username already taken" });

    const hashed = await bcrypt.hash(password, 10);
    const user = await User.create({ username, password: hashed });
    res.json({ token: makeToken(user), username: user.username });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user) return res.status(400).json({ error: "Wrong username or password" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(400).json({ error: "Wrong username or password" });

    res.json({ token: makeToken(user), username: user.username });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;