const { z } = require('zod');

// === تعريف المخططات (schemas) ===

// مخطط التحقق من هدف (لـ mafia_kill, doctor_save, detective_check, vote)
const targetIdSchema = z.object({
    targetId: z.string().min(1, "Target ID مطلوب")
});

// مخطط إعادة الانضمام بكود
const rejoinCodeSchema = z.object({
    code: z.string().min(1, "كود مطلوب"),
    username: z.string().min(2, "اسم المستخدم مطلوب")
});

// مخطط تعيين كلمة سر الجلسة
const sessionPasswordSchema = z.object({
    password: z.string().optional()
});

// مخطط تعيين عدد اللاعبين
const playerCountSchema = z.object({
    count: z.number().int().min(4).max(12)
});

// مخطط توليد كود إعادة الانضمام (للأدمن)
const generateCodeSchema = z.object({
    role: z.enum(["MAFIA", "DOCTOR", "DETECTIVE", "CITIZEN"])
});

// تصدير المخططات
module.exports = {
    targetIdSchema,
    rejoinCodeSchema,
    sessionPasswordSchema,
    playerCountSchema,
    generateCodeSchema
};