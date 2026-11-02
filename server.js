require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");
const User = require("./models/User");
const Message = require("./models/Message");
const Group = require("./models/Group");

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.log("MongoDB error:", err.message));

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static("public"));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use("/api", require("./routes/auth"));
app.use("/api/chat", require("./routes/chat"));

// Only logged-in users can connect to the chat
io.use((socket, next) => {
  try {
    socket.user = jwt.verify(socket.handshake.auth.token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    next(new Error("Not logged in"));
  }
});

// Room names: every user has a private room, every group has a room
const userRoom = (name) => "user:" + name;
const groupRoom = (id) => "group:" + id;

// ---------- AI assistant ----------
const AI_NAME = "AI Assistant";
const AI_MODEL = process.env.AI_MODEL || "openai/gpt-oss-120b";

// Sends the conversation to Groq and returns the answer text
async function askAI(history) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + process.env.GROQ_API_KEY,
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are a friendly, helpful AI assistant inside a chat app. " +
            "Answer any question clearly and keep replies short unless the user asks for detail. " +
            "Use plain text only: no markdown symbols like ** or #.",
        },
        ...history,
      ],
      max_completion_tokens: 2000,
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error((data.error && data.error.message) || "AI request failed");

  const text = data.choices[0].message.content;
  return (text || "").trim() || "Sorry, I couldn't come up with an answer. Try asking again.";
}

// Builds the reply for one user and sends it to them
async function answerWithAI(user) {
  io.to(userRoom(user)).emit("ai typing", { typing: true });
  try {
    let reply;
    try {
      if (!process.env.GROQ_API_KEY) {
        throw new Error("GROQ_API_KEY is missing in the .env file");
      }

      // The last 12 messages of this user's conversation with the AI
      const recent = await Message.find({
        $or: [
          { from: user, to: AI_NAME },
          { from: AI_NAME, to: user },
        ],
      })
        .sort({ createdAt: -1 })
        .limit(12);

      const history = recent
        .reverse()
        .filter((m) => m.text)
        .map((m) => ({ role: m.from === AI_NAME ? "assistant" : "user", content: m.text }));

      reply = await askAI(history);
    } catch (err) {
      console.log("AI error:", err.message);
      reply = "Sorry, I couldn't answer right now. Please try again in a moment.";
    }

    const msg = await Message.create({
      from: AI_NAME,
      to: user,
      text: reply.slice(0, 4000),
      read: false,
    });
    io.to(userRoom(user)).emit("private message", msg);
  } finally {
    io.to(userRoom(user)).emit("ai typing", { typing: false });
  }
}

// Only accept file links that our own upload route could have created
function cleanFile(file) {
  if (!file || typeof file.url !== "string") return undefined;
  const ok = /^\/uploads\/[a-f0-9]{32}\.(jpg|png|gif|webp|mp4|webm|mov)$/.test(file.url);
  if (!ok) return undefined;
  const kind = /\.(mp4|webm|mov)$/.test(file.url) ? "video" : "image";
  return { url: file.url, kind };
}

// Delete the uploaded files of some messages from the disk
function removeFiles(messages) {
  messages.forEach((m) => {
    if (m.file && m.file.url) {
      fs.unlink(path.join(__dirname, "uploads", path.basename(m.file.url)), () => {});
    }
  });
}

// username -> number of open tabs/devices (a person can have several)
const online = new Map();

io.on("connection", (socket) => {
  const me = socket.user.username;
  console.log(me, "connected");

  // My private room (for one-to-one messages)
  socket.join(userRoom(me));

  // Join the rooms of all groups I belong to
  Group.find({ members: me })
    .select("_id")
    .then((groups) => groups.forEach((g) => socket.join(groupRoom(g._id))))
    .catch((err) => console.log("group join error:", err.message));

  // Mark as online (tell everyone only when their first tab opens)
  online.set(me, (online.get(me) || 0) + 1);
  if (online.get(me) === 1) {
    io.emit("presence", { username: me, online: true });
  }

  // Tell the new connection who is online right now
  socket.emit("online users", [...online.keys()]);

  // ---------- One-to-one messages (also used for the AI chat) ----------
  socket.on("private message", async ({ to, text, file }) => {
    try {
      text = String(text || "").trim().slice(0, 2000);
      const toAI = to === AI_NAME;
      const f = toAI ? undefined : cleanFile(file); // the AI can't see photos or videos
      if (!to || (!text && !f)) return;

      const msg = await Message.create({ from: me, to, text, file: f, read: toAI });

      // Send to the receiver and back to the sender (all their open tabs)
      io.to(userRoom(to)).to(userRoom(me)).emit("private message", msg);

      if (toAI) await answerWithAI(me);
    } catch (err) {
      console.log("private message error:", err.message);
    }
  });

  // I opened a chat (or got a message in it): mark their messages to me as read
  socket.on("mark read", async ({ from }) => {
    if (!from) return;
    await Message.updateMany(
      { from, to: me, read: { $ne: true } },
      { read: true }
    );
    // Tell the sender their messages were read
    io.to(userRoom(from)).emit("messages read", { by: me });
  });

  // Delete the whole one-to-one chat between me and another user (for both)
  socket.on("delete chat", async ({ user }) => {
    try {
      if (!user) return;
      const filter = {
        $or: [
          { from: me, to: user },
          { from: user, to: me },
        ],
      };
      removeFiles(await Message.find({ ...filter, "file.url": { $exists: true } }));
      await Message.deleteMany(filter);
      io.to(userRoom(user)).to(userRoom(me)).emit("chat deleted", { a: me, b: user });
    } catch (err) {
      console.log("delete chat error:", err.message);
    }
  });

  // ---------- Delete a message (one-to-one or group) ----------
  socket.on("delete message", async ({ id }) => {
    try {
      if (!mongoose.isValidObjectId(id)) return;
      const msg = await Message.findById(id);
      if (!msg || msg.from !== me) return; // only the sender can delete

      removeFiles([msg]);
      await msg.deleteOne();
      if (msg.group) {
        io.to(groupRoom(msg.group)).emit("message deleted", { id });
      } else {
        io.to(userRoom(msg.to)).to(userRoom(me)).emit("message deleted", { id });
      }
    } catch (err) {
      console.log("delete message error:", err.message);
    }
  });

  // ---------- Groups ----------
  socket.on("create group", async ({ name, members }) => {
    try {
      name = String(name || "").trim().slice(0, 50);
      if (!name || !Array.isArray(members)) return;

      // Only keep members that really exist, and always include me
      const found = await User.find({ username: { $in: members.map(String) } }).select(
        "username"
      );
      const names = [...new Set([me, ...found.map((u) => u.username)])];
      if (names.length < 2) return;

      const group = await Group.create({ name, members: names, createdBy: me });

      // Put every member's open tabs into the group room, and tell them
      names.forEach((n) => {
        io.in(userRoom(n)).socketsJoin(groupRoom(group._id));
        io.to(userRoom(n)).emit("group created", group);
      });
    } catch (err) {
      console.log("create group error:", err.message);
    }
  });

  socket.on("group message", async ({ groupId, text, file }) => {
    try {
      text = String(text || "").trim().slice(0, 2000);
      const f = cleanFile(file);
      if ((!text && !f) || !mongoose.isValidObjectId(groupId)) return;

      const group = await Group.findOne({ _id: groupId, members: me });
      if (!group) return; // not a member

      const msg = await Message.create({ from: me, group: String(group._id), text, file: f });
      io.to(groupRoom(group._id)).emit("group message", msg);
    } catch (err) {
      console.log("group message error:", err.message);
    }
  });

  // Only the person who created the group can delete it
  socket.on("delete group", async ({ groupId }) => {
    try {
      if (!mongoose.isValidObjectId(groupId)) return;
      const group = await Group.findById(groupId);
      if (!group || group.createdBy !== me) return;

      const filter = { group: String(group._id) };
      removeFiles(await Message.find({ ...filter, "file.url": { $exists: true } }));
      await Message.deleteMany(filter);
      await group.deleteOne();

      io.to(groupRoom(group._id)).emit("group deleted", { groupId: String(group._id) });
      io.in(groupRoom(group._id)).socketsLeave(groupRoom(group._id));
    } catch (err) {
      console.log("delete group error:", err.message);
    }
  });

  // ---------- Disconnect ----------
  socket.on("disconnect", async () => {
    const count = (online.get(me) || 1) - 1;
    if (count > 0) {
      online.set(me, count); // still has another tab open
      return;
    }
    online.delete(me);
    const lastSeen = new Date();
    await User.updateOne({ username: me }, { lastSeen });
    io.emit("presence", { username: me, online: false, lastSeen });
  });
});

server.listen(3000, () => console.log("Running at http://localhost:3000"));