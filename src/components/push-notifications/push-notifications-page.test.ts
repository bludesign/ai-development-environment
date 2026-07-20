// @vitest-environment node
import { describe, expect, test } from "vitest";

import {
  editorStateFromSaved,
  editorStateWithPushType,
} from "./push-notifications-page";

describe("saved push notification editor state", () => {
  test("restores localization, summary, image, and critical sound fields", () => {
    const state = editorStateFromSaved({
      pushType: "alert",
      headers: { topic: "com.example.app", priority: 10 },
      aps: {
        alert: {
          title: "Title",
          "title-loc-key": "TITLE_KEY",
          "title-loc-args": ["One", "Two"],
          "subtitle-loc-key": "SUBTITLE_KEY",
          "subtitle-loc-args": ["Three"],
          "loc-key": "BODY_KEY",
          "loc-args": ["Four", "Five"],
          "launch-image": "Launch.png",
          "summary-arg": "Messages",
          "summary-arg-count": 3,
        },
        sound: { critical: 1, name: "alarm.aiff", volume: 0.5 },
      },
      custom: {},
      credentialId: "certificate-1",
    });

    expect(state).toMatchObject({
      titleLocKey: "TITLE_KEY",
      titleLocArgs: "One, Two",
      subtitleLocKey: "SUBTITLE_KEY",
      subtitleLocArgs: "Three",
      locKey: "BODY_KEY",
      locArgs: "Four, Five",
      launchImage: "Launch.png",
      summaryArg: "Messages",
      summaryArgCount: "3",
      soundName: "alarm.aiff",
      criticalSound: true,
      soundVolume: "0.5",
      credentialId: "certificate-1",
    });
  });

  test("keeps an omitted sound omitted", () => {
    const state = editorStateFromSaved({
      pushType: "alert",
      headers: { topic: "com.example.app", priority: 10 },
      aps: { alert: { title: "Silent" } },
      custom: {},
    });

    expect(state.soundName).toBe("");
    expect(state.criticalSound).toBe(false);
  });

  test("clears an MDM certificate when changing to another push type", () => {
    const mdm = editorStateFromSaved({
      pushType: "mdm",
      headers: { topic: "com.example.mdm", priority: 10 },
      aps: {},
      custom: {},
      credentialId: "mdm-certificate",
    });

    expect(editorStateWithPushType(mdm, "alert").credentialId).toBe("");
  });
});
