import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { GlobalAssistantWindow } from "./GlobalAssistantWindow.js";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("The desktop app root element is missing.");
}

const surface = new URLSearchParams(globalThis.location.search).get("surface");

createRoot(root).render(
  <StrictMode>
    {surface === "global-assistant" ? <GlobalAssistantWindow /> : <App />}
  </StrictMode>,
);
