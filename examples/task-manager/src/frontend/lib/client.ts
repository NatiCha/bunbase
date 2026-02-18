import { createTSBaseReact } from "tsbase/react";
import type { AppRouter } from "../../server.ts";

export const { TSBaseProvider, useTRPC, useAuth } =
  createTSBaseReact<AppRouter>({
    url: window.location.origin,
  });
