import React from "react";
import { createRoot } from "react-dom/client";

import "@mieweb/ui/styles.css";
import "@mieweb/ui/brands/mieweb.css";

import { App } from "./components/App";
import { t } from "./i18n";
import { startCollab } from "./store";

document.title = t("app.title");
startCollab();

const container = document.getElementById("root");
if (!container) {
  throw new Error("missing #root element");
}
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
