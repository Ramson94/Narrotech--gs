import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Leaf, Droplets, AlertCircle, Eye, EyeOff } from "lucide-react";

type Mode = "login" | "register";

export default function Login() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<Mode>("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      if (mode === "login") {
        await login(email, password);
      } else {
        if (!name.trim()) { setError("Full name is required"); setLoading(false); return; }
        await register(name, email, password);
      }
    } catch (err: any) {
      setError(err.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#0f2a3f] via-[#1a3a52] to-[#0d2233] p-4">
      {/* Background pattern */}
      <div className="absolute inset-0 opacity-5" style={{
        backgroundImage: "radial-gradient(circle at 25% 25%, #4CAF3D 0%, transparent 50%), radial-gradient(circle at 75% 75%, #1E6FA3 0%, transparent 50%)"
      }} />

      <div className="w-full max-w-md relative z-10">
        {/* Logo + Brand */}
        <div className="text-center mb-8">
          <div className="flex items-center justify-center mb-4">
            <img src="/narrowtech-logo.png" alt="NarrowTech GS" className="h-16 w-auto drop-shadow-lg" />
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">NarrowTech GS</h1>
          <p className="text-sm text-slate-400 mt-1">Crop Health Intelligence · Sentinel-2</p>

          {/* Index badges */}
          <div className="flex items-center justify-center gap-3 mt-3">
            <span className="flex items-center gap-1 text-xs bg-green-900/40 text-green-400 px-2 py-1 rounded-full border border-green-800/40">
              <Leaf size={11} /> NDVI
            </span>
            <span className="flex items-center gap-1 text-xs bg-blue-900/40 text-blue-400 px-2 py-1 rounded-full border border-blue-800/40">
              <Droplets size={11} /> MSI
            </span>
          </div>
        </div>

        <Card className="border-slate-700/50 bg-slate-900/80 backdrop-blur-sm shadow-2xl">
          <CardHeader className="pb-4">
            <CardTitle className="text-white text-lg">
              {mode === "login" ? "Sign in to your account" : "Create an account"}
            </CardTitle>
            <CardDescription className="text-slate-400">
              {mode === "login"
                ? "Monitor your fields' crop health from anywhere."
                : "Join NarrowTech GS and start monitoring your crops."}
            </CardDescription>
          </CardHeader>

          <CardContent>
            <form onSubmit={submit} className="space-y-4">
              {mode === "register" && (
                <div className="space-y-1.5">
                  <Label htmlFor="name" className="text-slate-300 text-sm">Full Name</Label>
                  <Input
                    id="name"
                    placeholder="e.g. Kofi Mensah"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    className="bg-slate-800 border-slate-600 text-white placeholder:text-slate-500 focus:border-[#1E6FA3]"
                    required
                  />
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="email" className="text-slate-300 text-sm">Email Address</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  className="bg-slate-800 border-slate-600 text-white placeholder:text-slate-500 focus:border-[#1E6FA3]"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="password" className="text-slate-300 text-sm">Password</Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPw ? "text" : "password"}
                    placeholder={mode === "register" ? "At least 6 characters" : "Your password"}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    className="bg-slate-800 border-slate-600 text-white placeholder:text-slate-500 focus:border-[#1E6FA3] pr-10"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
                  >
                    {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              {error && (
                <div className="flex items-center gap-2 text-red-400 bg-red-900/20 border border-red-800/40 rounded-md px-3 py-2 text-sm">
                  <AlertCircle size={14} className="shrink-0" />
                  {error}
                </div>
              )}

              <Button
                type="submit"
                disabled={loading}
                className="w-full bg-[#1E6FA3] hover:bg-[#1a5f8e] text-white font-semibold h-10"
              >
                {loading ? "Please wait…" : mode === "login" ? "Sign In" : "Create Account"}
              </Button>
            </form>

            <div className="mt-5 text-center text-sm text-slate-400">
              {mode === "login" ? (
                <>
                  Don't have an account?{" "}
                  <button onClick={() => { setMode("register"); setError(""); }}
                    className="text-[#4CAF3D] hover:text-[#5dbf4d] font-medium underline-offset-2 hover:underline">
                    Register here
                  </button>
                </>
              ) : (
                <>
                  Already have an account?{" "}
                  <button onClick={() => { setMode("login"); setError(""); }}
                    className="text-[#1E6FA3] hover:text-[#2980b9] font-medium underline-offset-2 hover:underline">
                    Sign in
                  </button>
                </>
              )}
            </div>

            {mode === "register" && (
              <p className="mt-3 text-xs text-slate-500 text-center">
                The first account created automatically becomes the admin.
              </p>
            )}
          </CardContent>
        </Card>

        <p className="text-center text-xs text-slate-600 mt-6">
          Powered by ESA Copernicus · Sentinel-2 · NarrowTech GeoSolution
        </p>
      </div>
    </div>
  );
}
