const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    from: { type: String, required: true },
    to: { type: String },     // used for one-to-one chats
    group: { type: String },  // used for group chats (the group's id)
    text: { type: String, default: "" },
    file: { url: String, kind: String }, // photo or video: { url, kind: "image" | "video" }
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Message", messageSchema);