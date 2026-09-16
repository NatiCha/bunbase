import { createBunBaseReact } from "@naticha/bunbase/react";
import * as schema from "../../schema";

export const { BunBaseProvider, api, useAuth, client } = createBunBaseReact({
  url: window.location.origin,
  schema,
  serverFields: { projects: ["ownerId"] },
});
