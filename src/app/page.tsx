import { Suspense } from 'react';
import { BookingWizardApp } from '@/components/BookingWizardApp';

export default function HomePage() {
  return (
    <div className="w-full min-h-screen bg-[#E6E8EA]">
      <Suspense fallback={<div className="min-h-screen bg-[#E6E8EA]" />}>
        <BookingWizardApp />
      </Suspense>
    </div>
  );
}
