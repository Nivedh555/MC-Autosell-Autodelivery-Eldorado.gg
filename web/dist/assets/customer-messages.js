export function createCustomerMessages(React, request) {
  const { createElement: h, useState, useEffect, useRef } = React;
  function Editor({ template, example, placeholders, onSaved }) {
    const [text, setText] = useState(template.text),
      [enabled, setEnabled] = useState(template.enabled),
      [busy, setBusy] = useState(false),
      [error, setError] = useState(""),
      [notice, setNotice] = useState("");
    const input = useRef(null),
      dirty = text !== template.text || enabled !== template.enabled;
    useEffect(() => {
      setText(template.text);
      setEnabled(template.enabled);
      setError("");
    }, [template.event, template.revision]);
    const supported = placeholders.filter(
      (key) =>
        key !== "minecraft_ign" ||
        !["new_order", "request_username", "invalid_username"].includes(
          template.event,
        ),
    );
    function invalid(value = text, on = enabled) {
      if (value.length > 2000) return "Use at most 2,000 characters.";
      if (on && !value.trim() && !template.required)
        return "Enter a message before enabling this event.";
      for (const match of value.matchAll(/\{([^{}]*)\}/g))
        if (!supported.includes(match[1]))
          return "This event does not support {" + match[1] + "}.";
      if (/[{}]/.test(value.replace(/\{([^{}]*)\}/g, "")))
        return "Use complete supported placeholders, for example {amount}.";
      return "";
    }
    async function save(reset = false) {
      const problem = reset ? "" : invalid();
      if (problem) {
        setError(problem);
        return;
      }
      if (busy) return;
      setBusy(true);
      setError("");
      setNotice("");
      try {
        const snapshot = await request(
          "/v3/customer-messages/" +
            encodeURIComponent(template.event) +
            (reset ? "/reset" : ""),
          {
            method: reset ? "POST" : "PUT",
            body: JSON.stringify(
              reset
                ? { revision: template.revision }
                : { text, enabled, revision: template.revision },
            ),
          },
        );
        onSaved(snapshot);
        setNotice(
          reset
            ? "Default restored and saved."
            : "Saved. Future messages use this version; queued messages keep their original text.",
        );
      } catch (e) {
        setError(e.message || "Could not save the template.");
      } finally {
        setBusy(false);
      }
    }
    function insert(key) {
      const node = input.current,
        start = node?.selectionStart ?? text.length,
        end = node?.selectionEnd ?? start,
        token = "{" + key + "}";
      setText(text.slice(0, start) + token + text.slice(end));
      setNotice("");
      setTimeout(() => {
        node?.focus();
        node?.setSelectionRange(start + token.length, start + token.length);
      }, 0);
    }
    const preview = text.replace(
      /\{([^{}]*)\}/g,
      (_, key) => example[key] ?? "{" + key + "}",
    );
    return h(
      "section",
      {
        className: "desk-panel customer-message-editor",
        "aria-labelledby": "message-editor-title",
      },
      h(
        "div",
        { className: "desk-row" },
        h("h3", { id: "message-editor-title" }, template.label),
        h(
          "span",
          { className: "message-revision" },
          "Saved version " + template.revision,
        ),
      ),
      h("p", null, template.description),
      h(
        "label",
        { className: "message-toggle" },
        h("input", {
          type: "checkbox",
          checked: enabled,
          disabled: busy || template.required,
          onChange: (e) => {
            setEnabled(e.target.checked);
            setError("");
            setNotice("");
          },
        }),
        template.required
          ? "Required authorization — always enabled"
          : "Send this message",
      ),
      h("label", { htmlFor: "customer-message-text" }, "Message text"),
      h("textarea", {
        id: "customer-message-text",
        ref: input,
        value: text,
        rows: 8,
        maxLength: 2000,
        disabled: busy,
        "aria-describedby":
          "message-template-help" + (error ? " message-template-error" : ""),
        "aria-invalid": Boolean(error),
        onBlur: () => setError(invalid()),
        onChange: (e) => {
          setText(e.target.value);
          setError("");
          setNotice("");
        },
      }),
      h(
        "p",
        { id: "message-template-help" },
        "Insert a placeholder below. Changes apply when a new message is scheduled.",
      ),
      h(
        "div",
        {
          className: "message-placeholders",
          "aria-label": "Insert placeholder",
        },
        ...supported.map((key) =>
          h(
            "button",
            { type: "button", key, disabled: busy, onClick: () => insert(key) },
            "{" + key + "}",
          ),
        ),
      ),
      error
        ? h(
            "p",
            {
              id: "message-template-error",
              role: "alert",
              className: "message-error",
            },
            error,
          )
        : null,
      h(
        "div",
        { className: "desk-row" },
        h(
          "button",
          {
            type: "button",
            className: "desk-primary",
            disabled: busy || !dirty,
            onClick: () => save(),
          },
          busy ? "Saving…" : "Save message",
        ),
        h(
          "button",
          { type: "button", disabled: busy, onClick: () => save(true) },
          "Reset to default",
        ),
        h("span", null, text.length + "/2,000 characters"),
      ),
      notice ? h("p", { role: "status" }, notice) : null,
      h(
        "div",
        { className: "message-preview", "aria-label": "Message preview" },
        h("h4", null, "Customer preview"),
        !enabled
          ? h("p", null, "Disabled: no message is sent for this event.")
          : h("pre", null, preview || "(No custom introduction)"),
        template.required
          ? h(
              "div",
              { className: "message-authorization" },
              h("strong", null, "Required authorization details"),
              h(
                "pre",
                null,
                "Confirm payment: 100000000 Donut dollars to BuyerOne.\nOrder: example-order\nReply yes to confirm or no to change the recipient.\nConfirmation: example revision",
              ),
              h(
                "p",
                null,
                "These details always use the actual recipient, exact amount, order and current conversation. Editing this message cannot authorize a payment.",
              ),
            )
          : null,
      ),
    );
  }
  return function CustomerMessages() {
    const [data, setData] = useState(null),
      [error, setError] = useState(""),
      [selected, setSelected] = useState("new_order"),
      [guideBusy, setGuideBusy] = useState(false);
    const load = async () => {
      try {
        const result = await request("/v3/customer-messages");
        if (!Array.isArray(result.templates))
          throw Error("Restart Autosell to load Customer Messages.");
        setData(result);
        setError("");
      } catch (e) {
        setError(e.message);
      }
    };
    useEffect(() => {
      load();
      window.addEventListener("autosell:authenticated", load);
      return () => window.removeEventListener("autosell:authenticated", load);
    }, []);
    async function guides(enabled) {
      if (guideBusy) return;
      setGuideBusy(true);
      setError("");
      try {
        setData(
          await request("/v3/customer-messages/guides", {
            method: "PUT",
            body: JSON.stringify({ enabled, revision: data.guides.revision }),
          }),
        );
      } catch (e) {
        setError(e.message);
      } finally {
        setGuideBusy(false);
      }
    }
    const template = data?.templates.find((item) => item.event === selected);
    return h(
      "div",
      { className: "customer-messages" },
      h(
        "section",
        { className: "desk-panel" },
        h("h3", null, "Customer Messages"),
        h(
          "p",
          null,
          "Choose the messages your customers receive at each order stage. Payment verification and genuine receipt uploads stay automatic.",
        ),
        h(
          "p",
          null,
          "Enable the completion message and confirmation-guide images to include them after future deliveries.",
        ),
        error
          ? h("p", { role: "alert", className: "message-error" }, error)
          : null,
        !data
          ? h(
              "p",
              { role: "status" },
              error
                ? "Customer messages could not load."
                : "Loading saved messages…",
            )
          : null,
        error
          ? h(
              "button",
              { type: "button", onClick: load },
              "Reload saved settings",
            )
          : null,
      ),
      data
        ? h(
            "div",
            { className: "customer-messages-layout" },
            h(
              "nav",
              {
                "aria-label": "Order message stages",
                className: "desk-panel message-stages",
              },
              ...data.templates.map((item) =>
                h(
                  "button",
                  {
                    type: "button",
                    key: item.event,
                    "aria-current":
                      selected === item.event ? "true" : undefined,
                    onClick: () => setSelected(item.event),
                  },
                  h("span", null, item.label),
                  h(
                    "small",
                    null,
                    item.required ? "Required" : item.enabled ? "On" : "Off",
                  ),
                ),
              ),
            ),
            template
              ? h(Editor, {
                  key: template.event,
                  template,
                  example: data.example,
                  placeholders: data.placeholders,
                  onSaved: setData,
                })
              : null,
          )
        : null,
      data
        ? h(
            "section",
            { className: "desk-panel" },
            h("h3", null, "Optional confirmation-guide images"),
            h(
              "p",
              null,
              "Send instructions for confirming delivery and leaving a review after the payment receipt.",
            ),
            h(
              "label",
              { className: "message-toggle" },
              h("input", {
                type: "checkbox",
                checked: data.guides.enabled,
                disabled: guideBusy,
                onChange: (e) => guides(e.target.checked),
              }),
              guideBusy
                ? "Saving guide preference…"
                : "Send confirmation-guide images",
            ),
            h(
              "p",
              null,
              "Saved version " +
                data.guides.revision +
                ". This change applies to future completion notifications.",
            ),
          )
        : null,
    );
  };
}
