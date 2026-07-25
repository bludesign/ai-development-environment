import { describe, expect, test } from "vitest";

import de from "../../../messages/de.json";
import en from "../../../messages/en.json";
import es from "../../../messages/es.json";
import fr from "../../../messages/fr.json";

import { notificationTypeDefinitions } from "./notification-types";

const locales = { de, en, es, fr };

/* The preferences table renders every definition through `t()`, so a type
   added here without a matching message throws MISSING_MESSAGE at render
   rather than falling back to the English label. */
describe("notification type messages", () => {
  const definitions = notificationTypeDefinitions();
  const categories = [...new Set(definitions.map(({ category }) => category))];

  test.each(Object.entries(locales))(
    "%s translates every type",
    (_, messages) => {
      const { types, categories: labels } = messages.notifications;
      expect(Object.keys(types).sort()).toEqual(
        definitions.map(({ key }) => key).sort(),
      );
      expect(Object.keys(labels).sort()).toEqual([...categories].sort());
    },
  );
});
