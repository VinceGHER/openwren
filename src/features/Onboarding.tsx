import {
  IconArrowLeft,
  IconArrowRight,
  IconBrandGoogle,
  IconCheck,
  IconCode,
  IconEyeOff,
  IconLock,
  IconMail,
  IconPaperclip,
  IconShieldCheck,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
import logo from "../../src-tauri/icons/128x128@2x.png";
import { backend } from "../backend";
import { REPOSITORY } from "../lib/links";
import { TEXT_SIZES } from "../lib/font";
import { useStore } from "../store";
import { preferAccountKind } from "./AddAccount";

const STEPS = ["Welcome", "Account", "Look", "Ready"] as const;

/** The filled accent button used only here: the one obvious next step on each screen. */
function Next({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex h-11 items-center gap-2 rounded-xl bg-brand px-5 text-card hover:opacity-90">
      {children}
    </button>
  );
}

function Point({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="flex gap-3.5">
      <div className="flex size-10 flex-none items-center justify-center rounded-xl bg-soft text-brand">{icon}</div>
      <div>
        <div className="text-ink">{title}</div>
        <div className="text-ink2">{text}</div>
      </div>
    </div>
  );
}

function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div>
      <div className="mb-2 text-ink2">{label}</div>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
        {options.map(([v, name]) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={value === v}
            onClick={() => onChange(v)}
            className={`h-9 rounded-full px-4 ${value === v ? "bg-soft text-brand" : "border border-edge text-ink2 hover:bg-hover"}`}
          >
            {name}
          </button>
        ))}
      </div>
    </div>
  );
}

/** A small picture of the app for the right-hand side: three messages, one of them flagged as suspicious. */
function Preview() {
  const row = "flex items-center gap-3 rounded-2xl bg-card px-4 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.06)]";
  const avatar = "flex size-9 flex-none items-center justify-center rounded-full text-xs";
  return (
    <div className="flex w-full max-w-[380px] flex-col gap-3" aria-hidden="true">
      <div className={row}>
        <div className={`${avatar} bg-[#1f1f1e] text-white`}>
          <IconMail size={17} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-ink">
            Mona Kane <span className="size-[7px] rounded-full bg-dot" /> <span className="ml-auto text-xs text-brand">9:41</span>
          </div>
          <div className="truncate text-ink2">Event announcement content</div>
        </div>
      </div>
      <div className={`${row} translate-x-6`}>
        <div className={`${avatar} bg-chip text-ink2`}>PS</div>
        <div className="min-w-0 flex-1">
          <div className="text-ink">PayPal Security</div>
          <div className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-warn px-2.5 py-0.5 text-xs text-on-warn">
            <IconShieldCheck size={14} /> Sender not confirmed
          </div>
        </div>
      </div>
      <div className={row}>
        <div className={`${avatar} bg-[#1DB954] text-white`}>
          <IconPaperclip size={17} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-ink">Weekly digest</div>
          <div className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-soft px-2.5 py-0.5 text-xs text-brand">
            <IconEyeOff size={14} /> 2 trackers removed
          </div>
        </div>
      </div>
    </div>
  );
}

/** First-run welcome: what OpenWren is, add an account, pick the look, start. */
export function Onboarding() {
  const accounts = useStore((s) => s.accounts);
  const settings = useStore((s) => s.settings);
  const { setSetting, setDialog, setWelcome } = useStore.getState();
  const [step, setStep] = useState(0);
  const had = useState(accounts.length)[0];

  // Adding an account in the dialog moves the welcome on by itself.
  useEffect(() => {
    if (step === 1 && accounts.length > had) setStep(2);
  }, [accounts.length, had, step]);

  const add = (kind: "google" | "imap") => {
    preferAccountKind(kind);
    setDialog("add-account");
  };
  const finish = () => {
    void setSetting("onboarded", "yes");
    setWelcome(false);
  };
  const card = "flex w-full items-center gap-4 rounded-2xl border border-edge px-5 py-4 text-left hover:border-line hover:bg-hover";

  return (
    <div className="absolute inset-0 z-[5] flex bg-card" role="dialog" aria-modal="true" aria-label="Welcome to OpenWren">
      <div className="flex min-w-0 flex-1 flex-col px-14 py-10">
        <div className="flex items-center gap-2.5">
          <img src={logo} alt="" className="size-8" />
          <span className="text-lg text-ink">OpenWren</span>
          <button type="button" onClick={finish} className="ml-auto rounded-lg px-3 py-1.5 text-ink3 hover:bg-hover hover:text-ink">
            Skip
          </button>
        </div>

        <div className="flex flex-1 flex-col justify-center py-8">
          <div className="max-w-[460px]">
            {step === 0 && (
              <>
                <h1 className="text-[34px] leading-tight text-ink">Mail that stays yours</h1>
                <p className="mt-3 text-[17px] text-ink2">OpenWren is an open-source mail app for Gmail and any other mail account. It keeps your mail on this computer and tells no one what you read.</p>
                <div className="mt-8 flex flex-col gap-5">
                  <Point icon={<IconLock size={20} />} title="Private by design" text="Your mail is stored encrypted on this computer. No tracking, no ads." />
                  <Point icon={<IconShieldCheck size={20} />} title="Watches your back" text="Trackers are removed and suspicious messages are flagged before you click." />
                  <Point icon={<IconMail size={20} />} title="All your mail in one place" text="Several accounts, one inbox, and search that reaches back years." />
                  <div className="flex gap-3.5">
                    <div className="flex size-10 flex-none items-center justify-center rounded-xl bg-soft text-brand">
                      <IconCode size={20} />
                    </div>
                    <div>
                      <div className="text-ink">Free and open source</div>
                      <div className="text-ink2">
                        No price, no ads. Every line of code is public, so you can check it yourself.{" "}
                        <button type="button" className="text-brand underline" onClick={() => void backend.openLink(REPOSITORY)}>
                          View the code
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
                <p className="mt-7 text-[13px] text-ink3">
                  OpenWren counts its users with one anonymous request a day: no name, no address, no mail. You can switch it off in Settings, under Privacy.
                </p>
              </>
            )}

            {step === 1 && (
              <>
                <h1 className="text-[30px] leading-tight text-ink">Add your mail account</h1>
                <p className="mt-3 text-ink2">Your password or sign-in is kept in your system's password store, never in OpenWren's files.</p>
                {accounts.length > 0 && (
                  <p className="mt-4 inline-flex items-center gap-2 rounded-full bg-soft px-3 py-1 text-brand">
                    <IconCheck size={16} /> {accounts.length === 1 ? accounts[0].address : `${accounts.length} accounts`} added
                  </p>
                )}
                <div className="mt-6 flex flex-col gap-3">
                  <button type="button" className={card} onClick={() => add("google")}>
                    <span className="flex size-11 flex-none items-center justify-center rounded-xl bg-soft text-brand">
                      <IconBrandGoogle size={22} />
                    </span>
                    <span>
                      <span className="block text-ink">Gmail</span>
                      <span className="block text-ink2">With an app password from your Google account</span>
                    </span>
                    <IconArrowRight size={18} className="ml-auto text-ink3" />
                  </button>
                  <button type="button" className={card} onClick={() => add("imap")}>
                    <span className="flex size-11 flex-none items-center justify-center rounded-xl bg-soft text-brand">
                      <IconMail size={22} />
                    </span>
                    <span>
                      <span className="block text-ink">Other mail account</span>
                      <span className="block text-ink2">Any provider, with your address and password (IMAP)</span>
                    </span>
                    <IconArrowRight size={18} className="ml-auto text-ink3" />
                  </button>
                </div>
              </>
            )}

            {step === 2 && (
              <>
                <h1 className="text-[30px] leading-tight text-ink">Make it yours</h1>
                <p className="mt-3 text-ink2">You can change all of this later in Settings.</p>
                <div className="mt-7 flex flex-col gap-6">
                  <Choice
                    label="Theme"
                    value={(settings.theme ?? "system") as "system" | "light" | "dark"}
                    onChange={(v) => void setSetting("theme", v)}
                    options={[
                      ["system", "Match my computer"],
                      ["light", "Light"],
                      ["dark", "Dark"],
                    ]}
                  />
                  <Choice label="Text size" value={settings.text_size ?? "15"} onChange={(v) => void setSetting("text_size", v)} options={TEXT_SIZES} />
                  <Choice
                    label="Time"
                    value={settings.time_format === "12" ? "12" : "24"}
                    onChange={(v) => void setSetting("time_format", v)}
                    options={[
                      ["24", "15:05"],
                      ["12", "3:05 PM"],
                    ]}
                  />
                </div>
              </>
            )}

            {step === 3 && (
              <>
                <div className="mb-5 flex size-14 items-center justify-center rounded-2xl bg-soft text-brand">
                  <IconCheck size={30} />
                </div>
                <h1 className="text-[30px] leading-tight text-ink">You're all set</h1>
                <p className="mt-3 text-ink2">
                  {accounts.length > 0 ? "Your mail is downloading in the background. The newest messages appear first; older ones follow." : "Add an account any time from Settings, under Accounts."}
                </p>
                <div className="mt-7 flex flex-col gap-2.5 text-ink2">
                  {[
                    ["Ctrl K", "Search all your mail"],
                    ["Ctrl N", "Write a new message"],
                    ["Right-click", "Block a sender, snooze, move or view the source"],
                  ].map(([keys, what]) => (
                    <div key={keys} className="flex items-center gap-3">
                      <kbd className="min-w-[92px] rounded-lg border border-edge bg-canvas px-2.5 py-1 text-center text-[13px] text-ink">{keys}</kbd>
                      {what}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-4">
          {step > 0 && (
            <button type="button" onClick={() => setStep(step - 1)} className="inline-flex h-11 items-center gap-2 rounded-xl px-3 text-ink2 hover:bg-hover">
              <IconArrowLeft size={18} /> Back
            </button>
          )}
          {step === 0 && (
            <Next onClick={() => setStep(1)}>
              Get started <IconArrowRight size={18} />
            </Next>
          )}
          {step === 1 &&
            (accounts.length > 0 ? (
              <Next onClick={() => setStep(2)}>
                Continue <IconArrowRight size={18} />
              </Next>
            ) : (
              <button type="button" onClick={() => setStep(2)} className="h-11 rounded-xl px-3 text-ink2 hover:bg-hover">
                Do this later
              </button>
            ))}
          {step === 2 && (
            <Next onClick={() => setStep(3)}>
              Continue <IconArrowRight size={18} />
            </Next>
          )}
          {step === 3 && <Next onClick={finish}>Open my inbox</Next>}
          <div className="ml-auto flex items-center gap-2" aria-label={`Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`}>
            {STEPS.map((name, i) => (
              <span key={name} className={`h-1.5 rounded-full ${i === step ? "w-6 bg-brand" : "w-1.5 bg-edge"}`} />
            ))}
          </div>
        </div>
      </div>

      <div className="hidden w-[44%] max-w-[560px] flex-none items-center justify-center bg-soft px-10 lg:flex">
        <Preview />
      </div>
    </div>
  );
}
