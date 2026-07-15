/**
 * Collapsible "Form config" panel (eSheet view only): the Patient form's
 * eSheet definition is editable at runtime, either as YAML (js-yaml dump /
 * load, validated with @esheet/core's formDefinitionSchema) or visually in
 * @esheet/builder (lazy-loaded, built from the vendor/eSheet submodule).
 * Apply hands the validated definition to the host; parse / validation
 * errors are announced inline (role=alert) and never break the live form.
 */
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { formDefinitionSchema } from "@esheet/core";
import type { FormDefinition } from "@esheet/core";
import { Button, Tabs, TabsList, TabsTrigger } from "@mieweb/ui";
import { dump, load } from "js-yaml";

import { t } from "../i18n";
import "./form-config-panel.scss";

const EsheetBuilder = lazy(async () => ({
  default: (await import("@esheet/builder")).EsheetBuilder,
}));

type ConfigTab = "yaml" | "browser";

interface FormConfigPanelProps {
  definition: FormDefinition;
  /** Bumped on every applied change — remounts the builder on fresh input. */
  revision: number;
  onApply(definition: FormDefinition): void;
  onReset(): void;
}

/** Validates an untrusted candidate definition into a FormDefinition. */
function validateDefinition(
  candidate: unknown,
): { definition: FormDefinition } | { error: string } {
  const result = formDefinitionSchema.safeParse(candidate);
  if (!result.success) {
    return {
      error: result.error.issues
        .map((issue) => `${issue.path.join(".") || "form"}: ${issue.message}`)
        .join("; "),
    };
  }
  return { definition: result.data as FormDefinition };
}

export function FormConfigPanel({
  definition,
  revision,
  onApply,
  onReset,
}: FormConfigPanelProps): React.JSX.Element {
  const [tab, setTab] = useState<ConfigTab>("yaml");
  const [yamlText, setYamlText] = useState(() => dump(definition));
  const [error, setError] = useState<string | null>(null);
  const builderDefinition = useRef<FormDefinition>(definition);

  // Reseed both editors whenever a definition is applied or reset.
  useEffect(() => {
    setYamlText(dump(definition));
    builderDefinition.current = definition;
    setError(null);
  }, [definition]);

  const apply = (): void => {
    let candidate: unknown;
    if (tab === "yaml") {
      try {
        candidate = load(yamlText);
      } catch (cause) {
        setError(
          t("config.error", {
            message: cause instanceof Error ? cause.message : String(cause),
          }),
        );
        return;
      }
    } else {
      candidate = builderDefinition.current;
    }
    const result = validateDefinition(candidate);
    if ("error" in result) {
      setError(t("config.error", { message: result.error }));
      return;
    }
    setError(null);
    onApply(result.definition);
  };

  return (
    <details className="form-config">
      <summary className="form-config-summary">{t("config.title")}</summary>
      <div className="form-config-body">
        <Tabs value={tab} onValueChange={(value) => setTab(value as ConfigTab)} variant="pills">
          <TabsList aria-label={t("config.tabsLabel")}>
            <TabsTrigger value="yaml">{t("config.tabYaml")}</TabsTrigger>
            <TabsTrigger value="browser">{t("config.tabBrowser")}</TabsTrigger>
          </TabsList>
        </Tabs>
        {tab === "yaml" ? (
          <textarea
            className="form-config-yaml"
            aria-label={t("config.yamlLabel")}
            rows={14}
            spellCheck={false}
            value={yamlText}
            onChange={(event) => setYamlText(event.target.value)}
          />
        ) : (
          <div className="form-config-builder">
            <Suspense
              fallback={<p className="form-config-loading">{t("config.loadingBuilder")}</p>}
            >
              <EsheetBuilder
                key={revision}
                definition={definition}
                onChange={(next) => {
                  builderDefinition.current = next;
                }}
              />
            </Suspense>
          </div>
        )}
        {error !== null && (
          <p className="form-config-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-config-actions">
          <Button variant="primary" size="sm" aria-label={t("config.applyLabel")} onClick={apply}>
            {t("config.apply")}
          </Button>
          <Button variant="outline" size="sm" aria-label={t("config.resetLabel")} onClick={onReset}>
            {t("config.reset")}
          </Button>
        </div>
      </div>
    </details>
  );
}
