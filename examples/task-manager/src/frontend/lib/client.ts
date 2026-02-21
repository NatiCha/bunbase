import { createBunBaseReact } from "bunbase/react";
import * as schema from "../../schema";

export const { BunBaseProvider, api, useAuth, client } =
  createBunBaseReact({
    url: window.location.origin,
    schema,
  });
