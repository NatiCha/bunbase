import { createBunBaseReact } from "bunbase/react";
import type * as schema from "../../schema";

export const { BunBaseProvider, api, useAuth } =
  createBunBaseReact<typeof schema>({
    url: window.location.origin,
  });
