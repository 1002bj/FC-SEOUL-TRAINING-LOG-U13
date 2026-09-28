import React, { useState, useEffect } from 'react';

export interface UpdateRecord {
  id: string;
  date: string;
  changes: string[];
}

// 새로운 기능 구현 또는 버그 수정 시 배열 맨 위(0번째)에 추가합니다.
export const UPDATES: UpdateRecord[] = [
  {
    id: 'v1.6.0',
    date: '2026-09-28',
    changes: [
      '지도자 경기 평가 화면에 "주기화 주제별 묶어보기" 모드 신설 (어느 주기화에 어떤 경기에 어느 선수가 출전했는지 한눈에 파악)',
      '주기화 대분류 탭(전체/패스/터치/드리블) 및 세부 주차 주제, 선수별 필터 기능 추가',
      '주제별 경기 및 선수 출전 현황(출전시간/포지션/목표/성공률/지도자 피드백 상태) 카드형 시각화 및 피드백 바로가기 지원'
    ]
  },
  {
    id: 'v1.5.0',
    date: '2026-09-28',
    changes: [
      '경기 평가 출전 시간(분) 입력 항목 신설 및 지도자/선수 자유로운 수정 지원',
      '경기 평가 기록 목록 및 대시보드 내 출전 시간(분) 뱃지 표시',
      '엑셀 백업 다운로드 시 경기 평가 시트에 "출전 시간(분)" 데이터 연동'
    ]
  },
  {
    id: 'v1.4.0',
    date: '2026-09-27',
    changes: [
      '경기 포지션(전반/후반) 기본값을 "미출전"으로 자동 설정',
      '경기 평가 프로필 사진 문구 정리 및 포지션 헤더 이모티콘 제거',
      '주차별 주기화 주제에 따른 오늘의 IDP 개인 목표 맞춤 예시(placeholder) 동적 안내',
      '전체 대시보드 표에 "⚽ 경기 평가" 열 신설 (최신 평가 현황 확인 및 원클릭 바로가기 지원)'
    ]
  },
  {
    id: 'v1.3.0',
    date: '2026-09-27',
    changes: [
      '오류 제보 플로팅 버튼 크기 20% 축소 최적화',
      '마우스 호버 시 부드러운 알약형 확장 및 "오류 제보" 텍스트 노출 인터랙션 적용'
    ]
  },
  {
    id: 'v1.2.0',
    date: '2026-09-27',
    changes: [
      '오류 및 불편사항 제보 시스템 신설 (우측 하단 버그 버튼 및 시스템 로그 첨부 기능)',
      '관리자 전용 오류 제보 내역 조회, 클립보드 복사 및 답변 관리 기능 추가',
      '경기 평가 화면 명칭 정리 및 원형 프로필 사진 변경 기능 최적화'
    ]
  },
  {
    id: 'v1.1.0',
    date: '2026-09-26',
    changes: [
      '전/후반 포지션 실시간 경기 평가 시스템 개편',
      '선수별 원형 프로필 사진 및 변경 기능 탑재'
    ]
  },
  {
    id: 'v1.0.0',
    date: '2026-09-25',
    changes: [
      'FC 서울 U13 트레이닝 일지 서비스 정식 런칭'
    ]
  }
];

export default function UpdateBanner() {
  const [isVisible, setIsVisible] = useState(false);
  const latestUpdate = UPDATES[0];

  useEffect(() => {
    if (!latestUpdate) return;
    
    // 특정 버전별로 '7일간 안보기' 설정 확인
    const hiddenUntil = localStorage.getItem(`hide_update_${latestUpdate.id}`);
    
    if (hiddenUntil) {
      const expiry = parseInt(hiddenUntil, 10);
      if (Date.now() < expiry) {
        setIsVisible(false);
        return;
      }
    }
    
    setIsVisible(true);
  }, [latestUpdate]);

  const handleHide = () => {
    // 7일을 밀리초로 계산 (7일 * 24시간 * 60분 * 60초 * 1000)
    const hideDuration = 7 * 24 * 60 * 60 * 1000; 
    localStorage.setItem(`hide_update_${latestUpdate.id}`, (Date.now() + hideDuration).toString());
    setIsVisible(false);
  };

  if (!isVisible || !latestUpdate) return null;

  return (
    <div className="bg-[#f0f9ff] border-b border-[#bae6fd] py-2 px-4 flex flex-col sm:flex-row justify-between items-start sm:items-center text-sm shadow-sm shrink-0">
      <div className="flex-1 pr-4 mb-2 sm:mb-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="bg-[#0284c7] text-white text-[10px] font-bold px-2 py-0.5 rounded-full">
            업데이트 안내
          </span>
          <span className="font-bold text-[#0c4a6e]">{latestUpdate.date}</span>
          <span className="text-[11px] text-[#0284c7] font-semibold">{latestUpdate.id}</span>
        </div>
        <ul className="text-[#0369a1] text-[12px] list-disc pl-5 m-0 leading-relaxed">
          {latestUpdate.changes.map((change, idx) => (
            <li key={idx}>{change}</li>
          ))}
        </ul>
      </div>
      <button 
        onClick={handleHide}
        className="text-[11px] text-[#0369a1] hover:text-[#0c4a6e] bg-white border border-[#bae6fd] px-3 py-1.5 rounded-full flex-shrink-0 transition-colors flex items-center gap-1 font-medium shadow-sm cursor-pointer"
      >
        ✕ 7일간 안보기
      </button>
    </div>
  );
}
