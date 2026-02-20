import { createTSBaseReact } from "tsbase/react";
import type * as schema from "../../schema";

export const { TSBaseProvider, api, useAuth } =
  createTSBaseReact<typeof schema>({
    url: window.location.origin,
  });
