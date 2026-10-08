"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@heroui/react";
import { Icon } from "@iconify/react";
import { useTranslations } from "next-intl";
import { useFullUser } from "@/components/full-user-provider";
import { authClient } from "@/lib/auth-client";
import {
    PROFILE_FIELDS,
    type ProfileFieldKey,
} from "@/lib/profile-completeness";

type SaveState = "idle" | "saving" | "saved" | "error";

export function ProfileEditor() {
    const t = useTranslations();
    const { user, refreshUser } = useFullUser();
    const router = useRouter();

    const [values, setValues] = useState<Record<ProfileFieldKey, string>>({
        name: user?.name ?? "",
        phone: user?.phone ?? "",
    });
    const [fieldState, setFieldState] = useState<Record<string, SaveState>>({});


    async function saveField(key: ProfileFieldKey) {
        const current = (values[key] ?? "").trim();
        const original = ((user?.[key] as string | null | undefined) ?? "").trim();
        if (current === original) return; // nothing changed
        setFieldState((s) => ({ ...s, [key]: "saving" }));
        const { error } = await authClient.updateUser({
            [key]: current || undefined,
        } as Parameters<typeof authClient.updateUser>[0]);
        if (error) {
            setFieldState((s) => ({ ...s, [key]: "error" }));
        } else {
            setFieldState((s) => ({ ...s, [key]: "saved" }));
            await refreshUser();
            // El resumen de Mi cuenta lo pinta el servidor: sin esto no se ve lo guardado.
            router.refresh();
        }
    }

    return (
        <div className="space-y-5">
            {/* Aquí había un anillo de progreso con el porcentaje de perfil
                completado, y confeti al llegar al cien. Eso es de un producto
                que necesita que un desconocido rellene sus datos. Aquí entra
                gente de la casa a cambiar su teléfono: el formulario, y ya.
                Cada campo se guarda solo al salir de él y lo dice. */}
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                {/* Email — read-only, not part of completeness */}
                <Input
                    label={t("myProfile.editor.email")}
                    labelPlacement="outside"
                    variant="bordered"
                    size="md"
                    value={user?.email ?? ""}
                    isDisabled
                    description={t("myProfile.editor.emailLocked")}
                    startContent={<Icon icon="lucide:mail" className="size-4 shrink-0 text-gray-400" aria-hidden />}
                    classNames={{
                        label: "text-sm font-medium text-gray-700 dark:text-gray-300",
                        inputWrapper: "bg-gray-100 dark:bg-slate-800 border-gray-200 dark:border-slate-700",
                    }}
                />
                {PROFILE_FIELDS.map((f) => {
                    const st = fieldState[f.key];
                    return (
                        <Input
                            key={f.key}
                            label={t(`myProfile.field.${f.key}.label`)}
                            labelPlacement="outside"
                            variant="bordered"
                            size="md"
                            placeholder={t(`myProfile.field.${f.key}.placeholder`)}
                            value={values[f.key]}
                            onValueChange={(v) => setValues((prev) => ({ ...prev, [f.key]: v }))}
                            onBlur={() => saveField(f.key)}
                            startContent={<Icon icon={f.icon} className="size-4 shrink-0 text-gray-400" aria-hidden />}
                            endContent={
                                st === "saving" ? (
                                    <Icon icon="lucide:loader-2" className="size-4 animate-spin text-gray-400" aria-hidden />
                                ) : st === "saved" ? (
                                    <Icon icon="lucide:check-circle-2" className="size-4 text-green-500" aria-hidden />
                                ) : st === "error" ? (
                                    <Icon icon="lucide:alert-circle" className="size-4 text-red-500" aria-hidden />
                                ) : null
                            }
                            description={
                                st === "error"
                                    ? t("myProfile.saveError")
                                    : t.has(`myProfile.field.${f.key}.why`)
                                      ? t(`myProfile.field.${f.key}.why`)
                                      : undefined
                            }
                            classNames={{
                                label: "text-sm font-medium text-gray-700 dark:text-gray-300",
                                inputWrapper:
                                    "bg-white dark:bg-slate-900 border-gray-300 dark:border-slate-600 data-[hover=true]:border-pv-azul/50 group-data-[focus=true]:border-pv-azul",
                            }}
                        />
                    );
                })}
            </div>
        </div>
    );
}
